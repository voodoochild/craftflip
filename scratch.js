// Ideas and shit

function Component (options) {
  this.item_id = options.item_id;
}

// Find a recipe for a given item_id
Component.prototype.isCrafted = function () {
  var deferred = q.defer();
  if (this.hasOwnProperty('_crafted')) {
    deferred.resolve(this._crafted);
  } else {
    client.search({
      index: 'gw2',
      type: 'recipe',
      size: 50,
      body: {
        query: {
          match: {
            output_item_id: this.item_id
          }
        }
      }
    }).then((function (results) {
      this._crafted = !!results.hits.total;
      deferred.resolve(this._crafted);
    }).bind(this));
  }
  return deferred.promise;
};

var c = new Component({item_id: 11541});


// Get all recipes
client.search({
  index: 'gw2',
  type: 'recipe',
  size: 50,
  body: {
    query: {
      match_all: {
        // output_item_id: this.item_id
      }
    }
  }
}).then(function (results) {
  console.log(results.hits.total);
});


// Get a single document
client.get({
  index: 'gw2',
  type: 'recipe',
  id: 7131
}).then(function (recipe) {
  console.log(recipe._source);
});


// Find all item_ids related to every recipe we know about
client.search({
  index: 'gw2',
  type: 'recipe'
}).then(function (results) {
  var item_ids = _.map(results.hits.hits, function (recipe) {
    recipe = recipe._source;
    var ids = [recipe.output_item_id];
    if (recipe.ingredients.length) {
      ids.push(_.map(recipe.ingredients, function (ingredient) {
        return ingredient.item_id;
      }));
    }
    return ids;
  });
  console.log(_.uniq(_.flatten(item_ids)));
});

getRecipeForItem = function (item_id) {
  var deferred = q.defer();
  client.search({
    index: 'gw2',
    type: 'recipe',
    size: 1,
    body: {
      query: {
        match: {
          output_item_id: item_id
        }
      }
    }
  }).then(function (results) {
    if (results.hits.total) {
      deferred.resolve(results.hits.hits[0]._source);
    } else {
      deferred.resolve(false);
    }
  });
  return deferred.promise;
};


buildComponents = function () {
  _.forEach(recipes, function (recipe) {
    makeComponent(recipe.output_item_id, recipe.ingredients);
    if (recipe.ingredients.length) {
      _.forEach(recipe.ingredients, function (ingredient) {
        makeComponent(ingredient.item_id);
      });
    }
  });
};

makeComponent = function (item_id, ingredients) {
  components[item_id] = new Component({
    item_id: item_id,
    ingredients: ingredients,
    price: prices[item_id]
  });
};



getPrices()
  .then(getRecipes)
  .then(function () {
    getRecipeForItem(10682)
      .then(traverseRecipe)
      .then(function (recipe) {
        var recipePrices = prices[recipe.output_item_id];
        if (recipePrices.craft) {
          var spread = recipePrices.sell - (recipePrices.craft * 1.15);
          console.log('['+ recipe.output_item_id +'] '+ rounded(spread/100) +'s');
        }
      });
  });




getRecipeForItem = function (item_id) {
  var deferred = q.defer();
  if (ingredientRecipeIds.hasOwnProperty(item_id)) {
    deferred.resolve(recipes[ingredientRecipeIds[item_id]]);
  } else {
    client.search({
      index: 'gw2',
      type: 'recipe',
      size: 1,
      body: {
        query: {
          match: {
            output_item_id: item_id
          }
        }
      }
    }).then(function (results) {
      if (results.hits.total) {
        deferred.resolve(recipes[results.hits.hits[0]._id]);
      } else {
        deferred.resolve(false);
      }
    });
  }
  return deferred.promise;
};

getNames = function () {
  var deferred = q.defer();
  request({
      url: 'http://api.gw2tp.com/1/bulk/items-names.json',
      json: true
  }, function (error, response, body) {
    _.forEach(body.items, function (item) {
      names[item[0]] = item[1];
    });
    deferred.resolve();
  });
  return deferred.promise;
};


traverseRecipe = function (recipe) {
  var deferred = q.defer();

  if (!prices[recipe.output_item_id]) {
    prices[recipe.output_item_id] = { buy: 0, sell: 0 };
    recipe.unavailable = true;
  } else if (prices[recipe.output_item_id].hasOwnProperty('craft')) {
    deferred.resolve(recipe);
    return deferred;
  }

  if (recipe.ingredients.length) {
    var getRecipePromises = [];
    var traversePromises = [];
    var sum = 0;

    _.forEach(recipe.ingredients, function (ingredient) {
      var p1 = getRecipeForItem(ingredient.item_id);
      getRecipePromises.push(p1);
      p1.then(function (ingredientRecipe) {
        if (ingredientRecipe) {
          ingredientRecipeIds[ingredient.item_id] = ingredientRecipe.recipe_id;
          var p2 = traverseRecipe(ingredientRecipe);
          traversePromises.push(p2);
          p2.then(function () {
            if (prices[ingredient.item_id]) {
              if (prices[ingredient.item_id].hasOwnProperty('craft')) {
                // component, already calculated
                sum += prices[ingredient.item_id].craft * ingredient.count;
              } else {
                // component, not seen before
                sum += prices[ingredient.item_id].sell * ingredient.count;
              }
            }
          });
        } else {
          if (prices[ingredient.item_id]) {
            // raw ingredient, add to sum for parent recipe
            sum += prices[ingredient.item_id].sell * ingredient.count;
          }
        }
      });
    });

    q.all(getRecipePromises)
      .then(function () {
        q.all(traversePromises)
          .then(function () {
            if (prices[recipe.output_item_id]) {
              prices[recipe.output_item_id].craft = sum;
            }
            deferred.resolve(recipe);
          });
      });
  } else {
    deferred.resolve(recipe);
  }

  return deferred.promise;
};


showPrices = function (recipe) {
  var recipePrices = prices[recipe.output_item_id];
  if (!recipe.unavailable && recipePrices.buy && recipePrices.sell && recipePrices.craft) {
    var spreadBuy = recipePrices.buy - ((recipePrices.craft * recipe.output_item_count) * 1.15);
    // if (spreadBuy > 1000) {
      var line = '\n'+ '-'.repeat(60) +'\n';
      process.stdout.write('\n+'+ rounded(spreadBuy/100) +' spread --- '+ recipe.output_item_name +
        ' (buy order for item at '+ rounded(recipePrices.buy/100) +')'+ line);
      renderRecipe(recipe);
      process.stdout.write(line);
    // }
  }
};

renderRecipe = function (recipe, count, level) {
  count = count || 1;
  level = level || 0;
  level && process.stdout.write('\n');
  process.stdout.write('\t\t'.repeat(level));

  var name = recipe.output_item_name || names[recipe.output_item_id] || '#'+ recipe.output_item_id;
  var pricing = prices[recipe.output_item_id];
  var from = '???';
  var each = '???';

  if (pricing && pricing.sell) {
    if (pricing.craft && pricing.craft < pricing.sell) {
      from = 'craft';
      each = rounded(pricing.craft/100);
    } else {
      from = 'buy';
      each = rounded(pricing.sell/100);
    }
  }

  process.stdout.write(name +' x '+ count +' ('+ from +' for '+ each +' each)');
  if (recipe.ingredients && recipe.ingredients.length) {
    level++;
    _.forEach(recipe.ingredients, function (ingredient) {
      var ingredientRecipe = false;
      ingredient.recipe_id = ingredientRecipeIds[ingredient.item_id];
      if (ingredient.recipe_id) {
        ingredientRecipe = recipes[ingredient.recipe_id];
      }
      if (!ingredientRecipe) {
        ingredientRecipe = {
          output_item_id: ingredient.item_id
        };
      }
      renderRecipe(ingredientRecipe, ingredient.count, level);
    });
  }
};




traverseRecipe = function (recipe) {
  // console.log('Traversing '+ recipe.output_item.name);
  if (!recipe || recipe.output_item.hasOwnProperty('acquisition')) { return; }

  recipe.output_item.prices = prices[recipe.output_item_id] || {};

  if (recipe.ingredients.length) {
    var craftedTotal = 0;
    _.forEach(recipe.ingredients, function (ingredient) {
      // console.log('--'+ ingredient.item.name);
      // Traverse ingredients with recipes, or assign prices to raw ingredients
      if (ingredient.recipe_id && recipes[ingredient.recipe_id]) {
        var ingredientRecipe = recipes[ingredient.recipe_id];
        traverseRecipe(ingredientRecipe);
        ingredient.item.prices = ingredientRecipe.output_item.prices;
      } else {
        ingredient.item.prices = prices[ingredient.item_id] || {};
        ingredient.item.acquisition = 'buy';
        // console.log('Buy '+ ingredient.item.name +' for '+ ingredient.item.prices.sell +', it isn\'t craftable');
      }

      // console.log(ingredient.item.name, ingredient.item.prices);

      // Add crafted or sell price to the craftedTotal
      if (ingredient.item.prices.crafted) {
        craftedTotal += ingredient.item.prices.crafted * ingredient.count;
      } else {
        craftedTotal += (ingredient.item.prices.sell || 0) * ingredient.count;
      }
    });

    // Compare the combined price of the ingredients with the sell price
    if (craftedTotal < (recipe.output_item.prices.sell || 0)) {
      recipe.output_item.prices.crafted = rounded(craftedTotal);
      recipe.output_item.acquisition = 'craft';
      // console.log('Craft '+ recipe.output_item.name +' for '+ recipe.output_item.prices.crafted);
    } else {
      recipe.output_item.acquisition = 'buy';
      // console.log('Buy '+ recipe.output_item.name +' for '+ recipe.output_item.prices.sell +', crafting costs '+ craftedTotal);
    }
  } else {
    // No ingredients, so buying is the only option
    recipe.output_item.acquisition = 'buy';
    // console.log('Buy '+ recipe.output_item.name +' for '+ recipe.output_item.prices.sell +', no ingredients');
  }
};
